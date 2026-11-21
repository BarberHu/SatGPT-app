import { GridTileOverlay, projectGridPoint, validPoint } from './GridTileOverlay';

export class BuildingTileOverlay extends GridTileOverlay {
  constructor(map, options) {
    super(map, { ...options, canvasClass: 'building-tiles-canvas' });
    this.refresh();
  }

  paintFeatures(ctx, features, longitude) {
    ctx.fillStyle = 'rgba(177, 136, 247, 0.55)';
    ctx.strokeStyle = '#552887';
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    for (const { geometry } of features) {
      if (geometry?.type === 'Polygon') this.paintPolygon(ctx, geometry.coordinates, longitude);
      if (geometry?.type === 'MultiPolygon') {
        for (const polygon of geometry.coordinates) this.paintPolygon(ctx, polygon, longitude);
      }
    }
  }

  paintPolygon(ctx, polygon, longitude) {
    const rings = polygon.map(ring => ring.map(point => projectGridPoint(this.map, point, longitude)));
    if (!rings.length || !rings.every(ring => ring.length >= 4 && ring.every(validPoint))) return;
    ctx.beginPath();
    for (const ring of rings) {
      ctx.moveTo(ring[0].x, ring[0].y);
      for (const point of ring.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.stroke();
  }
}
