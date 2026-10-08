import gc
import logging
import tempfile
from pathlib import Path
import numpy as np
import torch
from monai.data import MetaTensor


def run_inference_on_file(image_path, pre_transforms, post_transforms, amp_context, device, inferer, model):
    data = pre_transforms({'image': image_path})
    tensor = data['image'].float().unsqueeze(0).to(device)
    spatial_shape = tuple(tensor.shape[2:])
    inverse = post_transforms.transforms[0]
    with tempfile.TemporaryDirectory(prefix='bounded-logits-') as directory:
        logits = None
        with amp_context, torch.inference_mode():
            for z in range(spatial_shape[2]):
                prediction = inferer(tensor[..., z:z + 1], model)
                if logits is None:
                    channels = int(prediction.shape[1])
                    logits = np.memmap(Path(directory) / 'logits.bin', dtype=np.float32, mode='w+', shape=(spatial_shape[2], channels, spatial_shape[0], spatial_shape[1]))
                logits[z] = prediction[0, :, :, :, 0].cpu().numpy()
                del prediction
                if z % 32 == 0:
                    logging.info('Bounded reference inferred RAS slice %s/%s', z + 1, spatial_shape[2])
        logits.flush()
        best_scores = None
        best_labels = None
        for first in range(0, channels, 4):
            last = min(first + 4, channels)
            logging.info('Bounded reference inverting channels %s:%s/%s', first, last, channels)
            channel_logits = torch.from_numpy(np.ascontiguousarray(logits[:, first:last].transpose(1, 2, 3, 0)))
            inverted = inverse({'pred': MetaTensor(channel_logits), 'image': data['image'], 'image_meta_dict': data['image_meta_dict']})['pred']
            scores, labels = torch.max(inverted.as_tensor() if hasattr(inverted, 'as_tensor') else inverted, dim=0)
            if best_scores is None:
                best_scores = scores.clone()
                best_labels = labels.clone()
            else:
                wins = scores > best_scores
                best_scores[wins] = scores[wins]
                best_labels[wins] = labels[wins] + first
            del channel_logits, inverted, scores, labels
            gc.collect()
        del logits, best_scores
        result = {'pred': best_labels.unsqueeze(0)}
        for transform in post_transforms.transforms[2:]:
            result = transform(result)
        segmentation = result['pred'].detach().cpu().to(torch.int16).numpy().copy()
        import nibabel as nib
        assert segmentation.shape == nib.load(image_path).shape
        return segmentation
