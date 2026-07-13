export const qsmDefaults = Object.freeze({
  combinedMethod: 'standard',
  dipoleInversion: 'rts',
  unwrapMethod: 'romeo',
  backgroundRemoval: 'vsharp',
  fieldCalculationMethod: 'nonlinear_fit',
  referenceMean: true,
  romeo: {
    phaseGradientCoherence: true,
    magCoherence: true,
    magWeight: true
  },
  mcpc3ds: { sigma: [10, 10, 5] },
  vsharp: { threshold: 0.05, maxRadiusFactor: 18, minRadiusFactor: 2 },
  pdf: { tol: 0.00001, maxit: 100 },
  lbv: { tol: 0.001, maxit: 500 },
  ismv: { tol: 0.001, maxit: 500, radiusFactor: 5 },
  sharp: { threshold: 0.05, radiusFactor: 6 },
  rts: { delta: 0.15, mu: 100000, rho: 10, tol: 0.001, maxIter: 20, lsmrIter: 20 },
  tv: { lambda: 0.001, rho: 1, tol: 0.001, maxIter: 250 },
  tkd: { threshold: 0.15 },
  tsvd: { threshold: 0.15 },
  tikhonov: { lambda: 0.01 },
  nltv: { lambda: 0.001, mu: 1, tol: 0.001, maxIter: 250, newtonMaxIter: 10 },
  medi: { lambda: 0.000075, percentage: 0.3, maxIter: 30, cgMaxIter: 10, cgTol: 0.001, tol: 0.001, smv: false, smvRadius: 5 },
  tgv: { iterations: 1000, erosions: 3, alpha0: 0.0015, alpha1: 0.0005, stepSize: 1, tol: 0.001 },
  qsmart: {
    ilsqrTol: 0.01,
    ilsqrMaxIter: 50,
    vascSphereRadiusMm: 8,
    sdfSpatialRadius: 8,
    frangiScaleMin: 1,
    frangiScaleMax: 10,
    frangiScaleRatio: 2,
    frangiC: 500
  },
  swi: {
    hpSigma: [4, 4, 0],
    scaling: 'mip',
    strength: 4,
    mipWindow: 7
  }
});
