import * as THREE from "three";
import { advanceRoute, routePose } from "./network.js";

export function humanChallenge(network) {
  let route = { ...network.start };
  const path = [routePose(network, route).position];
  for (let i = 0; i < 48; i++) {
    route = advanceRoute(network, route, 0.25);
    path.push(routePose(network, route).position);
  }
  return { target: path.at(-1).clone(), path };
}
export class NavigationMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.axis = 2;
    this.lines = [];
    this.path = [];
  }
  configure(network, mask, start, target, path) {
    this.start = start.clone();
    this.target = target.clone();
    this.path = path;
    if (!mask)
      this.lines = network.edges.map((e) =>
        e.points.map((p) => new THREE.Vector3(...p)),
      );
    else {
      // Project a bounded sample of the same imported volume used by the game.
      const points = [];
      const stride = Math.max(
        1,
        Math.ceil(mask.field.reduce((sum, v) => sum + Number(v > 0), 0) / 5000),
      );
      let seen = 0;
      for (let i = 0; i < mask.field.length; i++)
        if (mask.field[i] && seen++ % stride === 0) {
          const x = i % mask.n,
            y = Math.floor(i / mask.n) % mask.n,
            z = Math.floor(i / (mask.n * mask.n));
          points.push([
            new THREE.Vector3(
              (x - mask.n / 2) * mask.scale[0],
              (y - mask.n / 2) * mask.scale[1],
              (z - mask.n / 2) * mask.scale[2],
            ),
          ]);
        }
      this.lines = points;
    }
    this.minSpan = mask ? Math.min(...mask.scale) * 20 : 18;
  }
  draw(player, heading) {
    if (!this.target) return;
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext("2d");
    const axis = this.axis,
      value = (p) => (axis === 2 ? p.z : p.y);
    const cx = (player.x + this.target.x) / 2,
      cy = (value(player) + value(this.target)) / 2;
    const span = Math.max(
      this.minSpan,
      Math.abs(player.x - this.target.x) * 1.6,
      Math.abs(value(player) - value(this.target)) * 1.6,
    );
    const scale = Math.min(w, h - 18) / span;
    const project = (p) => [
      w / 2 + (p.x - cx) * scale,
      h / 2 + (axis === 2 ? 1 : -1) * (value(p) - cy) * scale,
    ];
    ctx.fillStyle = "#081c28";
    ctx.fillRect(0, 0, w, h);
    const line = (points, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      points.forEach((p, i) => {
        const [x, y] = project(p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
      if (points.length === 1) {
        const [x, y] = project(points[0]);
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    };
    this.lines.forEach((points) => line(points, "#527988", 1.2));
    if (this.path.length) line(this.path, "#b49853", 2);
    const [sx, sy] = project(this.start);
    ctx.strokeStyle = "#d6eff0";
    ctx.strokeRect(sx - 3, sy - 3, 6, 6);
    const [tx, ty] = project(this.target);
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.moveTo(tx, ty - 7);
    ctx.lineTo(tx + 7, ty);
    ctx.lineTo(tx, ty + 7);
    ctx.lineTo(tx - 7, ty);
    ctx.closePath();
    ctx.fill();
    const [px, py] = project(player),
      [hx, hy] = project(player.clone().add(heading));
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.atan2(hy - py, hx - px));
    ctx.fillStyle = "#75f6ef";
    ctx.strokeStyle = "#081c28";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#d6eff0";
    ctx.font = "11px sans-serif";
    ctx.fillText(axis === 2 ? "TOP · X/Z" : "FRONT · X/Y", 8, 14);
  }
}
