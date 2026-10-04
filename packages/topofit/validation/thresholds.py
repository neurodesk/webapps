from math import isfinite


SURFACES = (
    "lh.white",
    "rh.white",
    "lh.pial",
    "rh.pial",
    "lh.registration",
    "rh.registration",
)
THRESHOLDS = {
    "surfaceMeanMm": 0.25,
    "surfaceP95Mm": 0.5,
    "surfaceMaxMm": 2.0,
    "registrationMeanDegrees": 0.1,
    "registrationP95Degrees": 0.25,
    "registrationRadiusMaxMm": 0.01,
    "qcWithinOneVoxel": 0.99,
}


def within_thresholds(report):
    if set(report["surfaces"]) != set(SURFACES):
        return False
    for name, surface in report["surfaces"].items():
        metrics = (
            (
                ("mean_angular_error_degrees", "registrationMeanDegrees"),
                ("p95_angular_error_degrees", "registrationP95Degrees"),
                ("max_radius_error_mm", "registrationRadiusMaxMm"),
            )
            if name.endswith("registration")
            else (
                ("mean_corresponding_distance_mm", "surfaceMeanMm"),
                ("p95_corresponding_distance_mm", "surfaceP95Mm"),
                ("max_corresponding_distance_mm", "surfaceMaxMm"),
            )
        )
        for metric, limit in metrics:
            value = surface[metric]
            if not isfinite(value) or value < 0 or value > THRESHOLDS[limit]:
                return False
    return all(
        isfinite(report["qc"][metric])
        and THRESHOLDS["qcWithinOneVoxel"] <= report["qc"][metric] <= 1
        for metric in (
            "white_within_one_voxel_symmetric_coverage",
            "pial_within_one_voxel_symmetric_coverage",
        )
    )
