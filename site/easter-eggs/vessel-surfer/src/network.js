import * as THREE from "three";

// Piecewise-linear interpolation preserves the validated in-lumen route samples.
// Unconstrained splines can cut through vessel walls at a bend.
class VesselPath extends THREE.Curve {
  constructor(points) {
    super();
    this.points = points.map((p) => new THREE.Vector3(...p));
    this.distances = [0];
    for (let i = 1; i < this.points.length; i++)
      this.distances.push(
        this.distances[i - 1] + this.points[i].distanceTo(this.points[i - 1]),
      );
    this.length = this.distances.at(-1);
  }
  getLength() {
    return this.length;
  }
  getPointAt(t, target = new THREE.Vector3()) {
    const d = THREE.MathUtils.clamp(t, 0, 1) * this.length;
    let lo = 0,
      hi = this.distances.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.distances[m] < d) lo = m;
      else hi = m;
    }
    const span = this.distances[hi] - this.distances[lo];
    return target
      .copy(this.points[lo])
      .lerp(this.points[hi], span ? (d - this.distances[lo]) / span : 0);
  }
  getPoint(t, target) {
    return this.getPointAt(t, target);
  }
  getTangentAt(t) {
    const delta = Math.min(0.1, 0.15 / this.length);
    return this.getPointAt(Math.min(1, t + delta))
      .sub(this.getPointAt(Math.max(0, t - delta)))
      .normalize();
  }
}
export function createNetwork(data) {
  if (!data?.edges?.length)
    throw new Error("Human vessel route data is missing.");
  const nodes = data.nodes.map((p) => new THREE.Vector3(...p));
  const edges = data.edges.map((edge, id) => {
    const curve = new VesselPath(edge.points);
    return { ...edge, id, curve, length: curve.getLength() };
  });
  const adjacency = nodes.map(() => []);
  for (const edge of edges) {
    adjacency[edge.a].push(edge);
    adjacency[edge.b].push(edge);
  }
  return { nodes, edges, adjacency, start: data.start };
}
export function choicesAt(network, node, previous) {
  const all = network.adjacency[node];
  const next = all.filter((e) => e.id !== previous);
  return next.length ? next : all;
}
export function advanceRoute(network, route, distance, choice = 0) {
  let edge = network.edges[route.edge],
    progress = route.progress + distance / edge.length;
  while (progress >= 1) {
    const remaining = (progress - 1) * edge.length;
    const node = route.reverse ? edge.a : edge.b;
    const options = choicesAt(network, node, edge.id);
    edge =
      options[((choice % options.length) + options.length) % options.length];
    route = { edge: edge.id, reverse: edge.b === node, progress: 0 };
    progress = remaining / edge.length;
    choice = 0;
  }
  return { ...route, progress };
}
export function routePose(network, route) {
  const edge = network.edges[route.edge],
    t = route.reverse ? 1 - route.progress : route.progress;
  return {
    position: edge.curve.getPointAt(t),
    direction: edge.curve
      .getTangentAt(t)
      .multiplyScalar(route.reverse ? -1 : 1),
  };
}
