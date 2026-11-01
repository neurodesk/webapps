# Rebuilds BrainQCNet's PPNet (resnet152, 19112020 run) from the upstream
# model.py, loads the released weights and exports logits to ONNX.
import sys, torch
from model import construct_PPNet

state_path, out_path = sys.argv[1:3]
ppnet = construct_PPNet('resnet152', pretrained=False, img_size=224,
                        prototype_shape=(2000, 128, 1, 1), num_classes=2,
                        prototype_activation_function='log', add_on_layers_type='regular')
ppnet.load_state_dict(torch.load(state_path, map_location='cpu'), strict=True)
ppnet.eval()

class Logits(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net
    def forward(self, x):
        # PPNet.forward's global min pooling, -max_pool2d(-d) over the whole
        # map, written as a reduction so the batch axis can stay dynamic.
        distances = self.net.prototype_distances(x)
        min_distances = torch.amin(distances, dim=(2, 3))
        return self.net.last_layer(self.net.distance_2_similarity(min_distances))

torch.onnx.export(Logits(ppnet), torch.zeros(1, 3, 224, 224), out_path,
                  input_names=['input'], output_names=['logits'],
                  dynamic_axes={'input': {0: 'batch'}, 'logits': {0: 'batch'}},
                  opset_version=17, do_constant_folding=True, dynamo=False)
