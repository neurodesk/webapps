#!/usr/bin/env python3
"""Export the pinned BrainNet 0.2 TopoFit program to browser ONNX stages.

The export preserves the full order-6 program. It replaces only operations for
which PyTorch 2.6 has no portable ONNX lowering: indexed reductions, Tensor.mT,
and rank-5 grid sampling. The replacements are tested against the source model
before any artifact is accepted.
"""

import argparse
import gc
import hashlib
import importlib.resources
import json
import platform
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from brainsynth.utilities import apply_affine
from brainnet.mesh.surface import load_deepsurfer_template
from brainnet.mesh.topology import Topology
from brainnet.modules.graph import GenericSurfaceModule, layers
from brainnet.networks.templatereg import TemplateRegAffine
from brainnet.networks.topofit import TopoFit
from torch.onnx import register_custom_op_symbolic


MODEL_SHAPE = (176, 208, 176)
TREGA_SHAPE = (192, 224, 192)
CONTAINER = "vnmd/topofit_0.5.1@sha256:dff22ad5577a1a7ba0530759e009f293271ea5ddfc3441fb35b61322bbd6ec29"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compact_constants(model):
    """Share identical tensor constants emitted once per unrolled graph step."""
    canonical = {}
    replacements = {}
    retained = []
    for node in model.graph.node:
        tensor = next(
            (attribute.t for attribute in node.attribute if attribute.name == "value"),
            None,
        )
        if node.op_type != "Constant" or tensor is None or len(node.output) != 1:
            retained.append(node)
            continue
        key = (tensor.data_type, tuple(tensor.dims), hashlib.sha256(tensor.SerializeToString()).digest())
        if key in canonical:
            replacements[node.output[0]] = canonical[key]
        else:
            canonical[key] = node.output[0]
            retained.append(node)
    for node in retained:
        for index, name in enumerate(node.input):
            node.input[index] = replacements.get(name, name)
    del model.graph.node[:]
    model.graph.node.extend(retained)


def normalize_output_names(model, names):
    """Honor the public tensor contract when constant folding drops output names."""
    for output, desired in zip(model.graph.output, names):
        current = output.name
        if current == desired:
            continue
        for node in model.graph.node:
            for index, value in enumerate(node.input):
                if value == current:
                    node.input[index] = desired
            for index, value in enumerate(node.output):
                if value == current:
                    node.output[index] = desired
        for value in (*model.graph.input, *model.graph.value_info, *model.graph.initializer):
            if value.name == current:
                value.name = desired
        output.name = desired


def mt_symbolic(graph, value):
    rank = value.type().dim()
    permutation = list(range(rank))
    permutation[-1], permutation[-2] = permutation[-2], permutation[-1]
    return graph.op("Transpose", value, perm_i=permutation)


def export_edge_forward(self, features):
    own = self.conv_self(features)
    other = self.conv_other(features)
    neighbor_sum = other * 0.0
    for column in range(self.export_neighbors.shape[1]):
        gathered = other[..., self.export_neighbors[:, column]]
        neighbor_sum = neighbor_sum + gathered * self.export_neighbor_mask[None, None, :, column]
    neighbor_mean = neighbor_sum / self.export_degree[None, None]
    return (own + neighbor_mean - other).reshape(
        1, self.out_channels, self.export_degree.shape[0]
    )


def export_pool(self, features, reduce="amax"):
    if reduce != "amax":
        raise ValueError(f"Unexpected TopoFit graph pooling reduction: {reduce}")
    output = self.subsample_array(features)
    for column in range(self.export_pool_neighbors.shape[1]):
        output = torch.maximum(output, features[..., self.export_pool_neighbors[:, column]])
    return output


class ExportInstanceNorm(torch.autograd.Function):
    @staticmethod
    def forward(ctx, features, scale, bias, epsilon):
        return torch.nn.functional.instance_norm(
            features,
            weight=None,
            bias=None,
            use_input_stats=True,
            momentum=0.1,
            eps=epsilon,
        )

    @staticmethod
    def symbolic(graph, features, scale, bias, epsilon):
        return graph.op(
            "InstanceNormalization",
            features,
            scale,
            bias,
            epsilon_f=float(epsilon),
        )


def export_instance_norm_1d(self, features):
    normalized = ExportInstanceNorm.apply(
        features,
        self.export_scale,
        self.export_bias,
        self.eps,
    )
    return normalized.reshape(1, self.num_features, int(features.shape[-1]))


def export_grid_sample(self, image, vertices):
    """PyTorch zero-padded trilinear sampling for N,C,W,H,D and N,3,V."""
    n, channels, width, height, depth = image.shape
    flat = image.reshape(n, channels, -1)
    scale = torch.tensor(
        [
            (width - 1) / (MODEL_SHAPE[0] - 1),
            (height - 1) / (MODEL_SHAPE[1] - 1),
            (depth - 1) / (MODEL_SHAPE[2] - 1),
        ],
        dtype=vertices.dtype,
        device=vertices.device,
    )[None, :, None]
    coordinates = vertices * scale
    low = torch.floor(coordinates)
    high = low + 1.0
    fraction = coordinates - low
    output = flat[:, :, :1].expand(n, channels, vertices.shape[-1]) * 0.0
    for use_high_x in (False, True):
        x = high[:, 0] if use_high_x else low[:, 0]
        x_weight = fraction[:, 0] if use_high_x else 1.0 - fraction[:, 0]
        for use_high_y in (False, True):
            y = high[:, 1] if use_high_y else low[:, 1]
            y_weight = fraction[:, 1] if use_high_y else 1.0 - fraction[:, 1]
            for use_high_z in (False, True):
                z = high[:, 2] if use_high_z else low[:, 2]
                z_weight = fraction[:, 2] if use_high_z else 1.0 - fraction[:, 2]
                valid = (
                    (x >= 0)
                    & (x < width)
                    & (y >= 0)
                    & (y < height)
                    & (z >= 0)
                    & (z < depth)
                )
                index = (
                    x.clamp(0, width - 1) * height * depth
                    + y.clamp(0, height - 1) * depth
                    + z.clamp(0, depth - 1)
                ).long()
                values = torch.gather(flat, 2, index[:, None].expand(-1, channels, -1))
                weight = x_weight * y_weight * z_weight * valid
                output = output + values * weight[:, None]
    return output


def validate_grid_sample_lowering():
    """Prove the portable sampler against BrainNet's native normalized sampling."""
    generator = torch.Generator().manual_seed(17)
    vertices = torch.rand((1, 3, 97), generator=generator)
    vertices *= torch.tensor(MODEL_SHAPE, dtype=torch.float32)[None, :, None]
    center = 0.5 * (torch.tensor(MODEL_SHAPE, dtype=torch.float32) - 1.0)
    normalized = (vertices - center[None, :, None]) / center[None, :, None]
    for shape in (
        (22, 26, 22),
        (44, 52, 44),
        (88, 104, 88),
        MODEL_SHAPE,
    ):
        image = torch.rand((1, 1, *shape), generator=generator)
        expected = torch.nn.functional.grid_sample(
            image.swapaxes(2, 4),
            normalized.mT[:, :, None, None],
            align_corners=True,
        )[..., 0, 0]
        actual = export_grid_sample(None, image, vertices)
        error = torch.abs(expected - actual)
        if error.max().item() > 2e-5:
            raise ValueError(
                f"Portable grid sampling parity failed for {shape}: {error.max().item()}"
            )


def install_export_lowerings():
    register_custom_op_symbolic("aten::mT", mt_symbolic, 20)
    layers.EdgeConvolution.forward = export_edge_forward
    Topology.pool = export_pool
    GenericSurfaceModule.grid_sample = export_grid_sample
    torch.nn.InstanceNorm1d.forward = export_instance_norm_1d


def prepare_export(model):
    """Materialize static graph degrees before tracing begins."""
    for module in model.modules():
        if isinstance(module, layers.EdgeConvolution) and not hasattr(module, "export_degree"):
            count = int(module.reduce_index.max().item()) + 1
            degree = torch.bincount(module.reduce_index, minlength=count)
            width = int(degree.max().item())
            neighbors = torch.zeros((count, width), dtype=torch.long)
            mask = torch.zeros((count, width), dtype=torch.float32)
            order = torch.argsort(module.reduce_index, stable=True)
            targets = module.reduce_index[order].long()
            sources = module.gather_index[order].long()
            starts = torch.repeat_interleave(torch.cumsum(degree, 0) - degree, degree)
            columns = torch.arange(targets.numel()) - starts
            neighbors[targets, columns] = sources
            mask[targets, columns] = 1.0
            degree = degree.to(module.conv_other.weight.dtype)
            module.register_buffer("export_degree", degree, persistent=False)
            module.register_buffer("export_neighbors", neighbors, persistent=False)
            module.register_buffer("export_neighbor_mask", mask, persistent=False)
        if isinstance(module, torch.nn.InstanceNorm1d) and not hasattr(module, "export_scale"):
            module.register_buffer(
                "export_scale",
                torch.ones(module.num_features, dtype=torch.float32),
                persistent=False,
            )
            module.register_buffer(
                "export_bias",
                torch.zeros(module.num_features, dtype=torch.float32),
                persistent=False,
            )
        if isinstance(module, layers.Pool) and not hasattr(module.topology, "export_pool_neighbors"):
            topology = module.topology
            count = topology.n_vertices_lower_order()
            degree = torch.bincount(topology.pool_index_reduce.long(), minlength=count)
            neighbors = torch.arange(count, dtype=torch.long)[:, None].expand(-1, int(degree.max().item())).clone()
            cursor = torch.zeros(count, dtype=torch.long)
            for target, source in zip(topology.pool_index_reduce, topology.pool_index_gather):
                row = int(target.item())
                neighbors[row, int(cursor[row].item())] = source
                cursor[row] += 1
            topology.register_buffer("export_pool_neighbors", neighbors, persistent=False)


class TregaStage(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.model = TemplateRegAffine.from_pretrained().eval()

    def forward(self, image, voxel_to_ras):
        features = self.model.image_fx_pre(image)
        features = self.model.image_fx_unet(features)["dec:3"]
        features = self.model.image_fx_post(features)
        shape = features.shape[-3:]
        grid = torch.stack(
            torch.meshgrid(
                [torch.arange(0, 2 * size, 2, device=image.device) for size in shape],
                indexing="ij",
            )
        )[None]
        mass = features.sum((-3, -2, -1), keepdim=True).abs() + 1e-6
        normalized = features / mass
        normalized_mass = mass.reshape(mass.shape[0], mass.shape[1], 1)
        normalized_mass = normalized_mass / normalized_mass.sum()
        barycenters = torch.sum(grid[:, None] * normalized[:, :, None], (-3, -2, -1))
        targets = apply_affine(voxel_to_ras, barycenters)
        templates = torch.cat(tuple(self.model.template_points.values()), dim=0)
        return targets, normalized_mass, templates


class FeatureStage(torch.nn.Module):
    def __init__(self, contrast):
        super().__init__()
        self.model = TopoFit.from_pretrained(contrast, "1mm").unet.eval()

    def forward(self, image):
        features = self.model(image)
        return tuple(features[name] for name in ("dec:0", "dec:1", "dec:2", "dec:3"))


class WhiteOrderStage(torch.nn.Module):
    def __init__(self, graph, order, single_step=False):
        super().__init__()
        self.deform = graph.white_deform[str(order)]
        self.step_size = graph.white_step_size[order]
        self.n_steps = 1 if single_step else graph.white_n_steps[order]
        self.out_groups = graph.white_out_groups

    def forward(self, dec0, dec1, dec2, dec3, vertices, uncertainty, registration):
        features = (dec0, dec1, dec2, dec3)
        vertices = vertices.mT
        uncertainty = uncertainty.mT
        registration = registration.mT
        for _ in range(self.n_steps):
            sampled = torch.cat(
                tuple(export_grid_sample(self, feature, vertices) for feature in features),
                dim=1,
            )
            dv, du, dr = self.deform(sampled).split(self.out_groups, dim=1)
            vertices = vertices + self.step_size * dv
            uncertainty = uncertainty + self.step_size * du
            registration = registration + self.step_size * dr
            registration = 100.0 * registration / torch.linalg.vector_norm(
                registration, dim=1, keepdim=True, dtype=registration.dtype
            )
        return vertices.mT, uncertainty.mT, registration.mT


class PialStage(torch.nn.Module):
    def __init__(self, graph, single_step=False):
        super().__init__()
        self.deform = graph.pial_deform
        self.step_size = graph.pial_step_size
        self.n_steps = 1 if single_step else graph.pial_n_steps
        self.out_groups = graph.pial_out_groups

    def forward(self, dec0, dec1, dec2, dec3, white, uncertainty):
        features = (dec0, dec1, dec2, dec3)
        vertices = white.mT
        uncertainty = uncertainty.mT
        for _ in range(self.n_steps):
            sampled = torch.cat(
                tuple(export_grid_sample(self, feature, vertices) for feature in features),
                dim=1,
            )
            dv, du = self.deform(sampled).split(self.out_groups, dim=1)
            vertices = vertices + self.step_size * dv
            uncertainty = uncertainty + self.step_size * du
        return vertices.mT, uncertainty.mT


def export(model, inputs, path, input_names, output_names):
    prepare_export(model)
    print(f"Exporting {path.name}...", flush=True)
    started = time.time()
    torch.onnx.export(
        model,
        inputs,
        path,
        input_names=input_names,
        output_names=output_names,
        opset_version=20,
        dynamo=False,
        do_constant_folding=True,
    )
    value = onnx.load(path)
    compact_constants(value)
    normalize_output_names(value, output_names)
    onnx.checker.check_model(value)
    onnx.save(value, path)
    return {
        "filename": path.name,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "seconds": time.time() - started,
        "operators": sorted({node.op_type for node in value.graph.node}),
        "inputs": input_names,
        "outputs": output_names,
    }


def validate(model, inputs, path, names, tolerances):
    with torch.no_grad():
        expected = model(*inputs)
    if isinstance(expected, torch.Tensor):
        expected = (expected,)
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    feeds = {name: value.detach().cpu().numpy() for name, value in zip(names, inputs)}
    actual = session.run(None, feeds)
    cases = []
    for source, converted in zip(expected, actual):
        source = source.detach().cpu().numpy()
        error = np.abs(source - converted)
        cases.append({"maxAbs": float(error.max()), "meanAbs": float(error.mean())})
    passed = all(
        case["maxAbs"] <= tolerances[0] and case["meanAbs"] <= tolerances[1]
        for case in cases
    )
    if not passed:
        raise ValueError(f"ONNX parity failed for {path.name}: {cases}")
    del session, expected, actual
    gc.collect()
    return cases


def write_assets(output):
    template = load_deepsurfer_template(0, "white")
    registration = load_deepsurfer_template(0, "sphere.reg")
    graph = TopoFit.from_pretrained("t1w", "1mm").graph
    topologies = graph.out_topology
    arrays = {
        "faces-lh.i32": topologies["lh"].faces.detach().cpu().numpy().astype("<i4"),
        "faces-rh.i32": topologies["rh"].faces.detach().cpu().numpy().astype("<i4"),
        "template-lh.f32": template["lh"].vertices.detach().cpu().numpy().astype("<f4"),
        "template-rh.f32": template["rh"].vertices.detach().cpu().numpy().astype("<f4"),
        "registration-lh.f32": registration["lh"].vertices.detach().cpu().numpy().astype("<f4"),
        "registration-rh.f32": registration["rh"].vertices.detach().cpu().numpy().astype("<f4"),
    }
    for order in range(6):
        arrays[f"subdivide-order-{order}-edges.i32"] = (
            graph.topologies[order].vertex_adjacency.detach().cpu().numpy().astype("<i4")
        )
    records = []
    for filename, values in arrays.items():
        path = output / filename
        values.tofile(path)
        records.append(
            {
                "filename": filename,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
                "shape": list(values.shape),
                "dtype": str(values.dtype),
            }
        )
    return records


def surface_fixture(contrast, target_order):
    """Build deterministic, anatomically placed inputs for one surface stage."""
    feature_shapes = (
        (1, 128, 22, 26, 22),
        (1, 64, 44, 52, 44),
        (1, 32, 88, 104, 88),
        (1, 16, 176, 208, 176),
    )
    graph = TopoFit.from_pretrained(contrast, "1mm").graph.eval()
    vertices = load_deepsurfer_template(0, "white")["lh"].vertices
    vertices = vertices + torch.tensor([88.0, 104.0, 88.0])
    uncertainty = torch.zeros_like(vertices)
    registration = load_deepsurfer_template(0, "sphere.reg")["lh"].vertices
    features = tuple(torch.rand(shape, dtype=torch.float32) for shape in feature_shapes)
    with torch.no_grad():
        for order in range(target_order):
            stage = WhiteOrderStage(graph, order).eval()
            prepare_export(stage)
            vertices, uncertainty, registration = stage(
                *features,
                vertices,
                uncertainty,
                registration,
            )
            if order < 6:
                topology = graph.topologies[order]
                vertices = topology.subdivide_vertices(vertices)
                uncertainty = topology.subdivide_vertices(uncertainty)
                registration = topology.subdivide_vertices(registration)
                registration = graph._project_to_sphere(registration.mT).mT
    return graph, features, vertices, uncertainty, registration


def export_one(asset, output, skip_validation):
    """Export one graph so the parent process can reclaim all trace memory."""
    torch.manual_seed(0)
    if asset == "trega":
        model = TregaStage().eval()
        inputs = (
            torch.rand((1, 1, *TREGA_SHAPE), dtype=torch.float32),
            torch.eye(4, dtype=torch.float32)[None],
        )
        path = output / "trega-synth-random.onnx"
        names = ["image", "voxel_to_ras"]
        record = export(model, inputs, path, names, ["targets", "weights", "templates"])
        record["iterations"] = 1
        tolerance = (0.005, 0.0005)
    elif asset.endswith("-features"):
        contrast = asset.removesuffix("-features")
        model = FeatureStage(contrast).eval()
        inputs = (torch.rand((1, 1, *MODEL_SHAPE), dtype=torch.float32),)
        path = output / f"topofit-{contrast}-1mm-features.onnx"
        names = ["image"]
        record = export(model, inputs, path, names, ["dec0", "dec1", "dec2", "dec3"])
        record["iterations"] = 1
        tolerance = (0.005, 0.0005)
    elif "-white-" in asset:
        contrast, order_text = asset.split("-white-")
        order = int(order_text)
        graph, features, vertices, uncertainty, registration = surface_fixture(contrast, order)
        model = WhiteOrderStage(graph, order, single_step=True).eval()
        inputs = features + (vertices, uncertainty, registration)
        path = output / f"topofit-{contrast}-1mm-white-order-{order}.onnx"
        names = ["dec0", "dec1", "dec2", "dec3", "vertices", "uncertainty", "registration"]
        record = export(
            model,
            inputs,
            path,
            names,
            ["vertices_out", "uncertainty_out", "registration_out"],
        )
        record["iterations"] = graph.white_n_steps[order]
        tolerance = (0.001, 0.00005)
    elif asset.endswith("-pial"):
        contrast = asset.removesuffix("-pial")
        graph, features, vertices, uncertainty, _ = surface_fixture(contrast, 7)
        model = PialStage(graph, single_step=True).eval()
        inputs = features + (vertices, uncertainty)
        path = output / f"topofit-{contrast}-1mm-pial.onnx"
        names = ["dec0", "dec1", "dec2", "dec3", "white", "uncertainty"]
        record = export(model, inputs, path, names, ["pial", "uncertainty_out"])
        record["iterations"] = graph.pial_n_steps
        tolerance = (0.001, 0.00005)
    else:
        raise ValueError(f"Unknown export asset: {asset}")
    if not skip_validation:
        record["parity"] = validate(model, inputs, path, names, tolerance)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--skip-validation", action="store_true")
    parser.add_argument("--asset", help=argparse.SUPPRESS)
    parser.add_argument("--record", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    install_export_lowerings()
    if args.asset is None:
        validate_grid_sample_lowering()
    if args.asset:
        if args.record is None:
            parser.error("--record is required with --asset")
        record = export_one(args.asset, args.output, args.skip_validation)
        args.record.write_text(json.dumps(record, indent=2) + "\n")
        return

    assets = ["trega"]
    for contrast in ("t1w", "synth"):
        assets.append(f"{contrast}-features")
        assets.extend(f"{contrast}-white-{order}" for order in range(7))
        assets.append(f"{contrast}-pial")
    records = []
    for index, asset in enumerate(assets):
        record_path = args.output / f".export-record-{index}.json"
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            str(args.output),
            "--asset",
            asset,
            "--record",
            str(record_path),
        ]
        if args.skip_validation:
            command.append("--skip-validation")
        subprocess.run(command, check=True)
        records.append(json.loads(record_path.read_text()))
        record_path.unlink()

    brainnet_root = importlib.resources.files("brainnet")
    checkpoint_paths = {
        "trega": Path(str(brainnet_root.joinpath("resources/models/trega/synth_random_state.pt"))),
        "topofitT1w": Path(str(brainnet_root.joinpath("resources/models/topofit/t1w_1mm_state.pt"))),
        "topofitSynth": Path(str(brainnet_root.joinpath("resources/models/topofit/synth_1mm_state.pt"))),
    }
    report = {
        "schemaVersion": 1,
        "status": "onnx-cpu-parity-passed" if not args.skip_validation else "exported-unvalidated",
        "source": {
            "openReconVersion": "0.5.1",
            "container": CONTAINER,
            "brainnet": "0.2",
            "brainsynth": "0.1",
            "checkpointSha256": {
                name: sha256(checkpoint) for name, checkpoint in checkpoint_paths.items()
            },
        },
        "tools": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "onnx": onnx.__version__,
            "onnxruntime": ort.__version__,
        },
        "models": records,
        "assets": write_assets(args.output),
    }
    (args.output / "conversion-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
