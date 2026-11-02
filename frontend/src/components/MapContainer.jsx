import React from 'react';
import { SharedMapViewport, useSharedMap } from '../map/SharedMapContext';
import BasicMapController from '../map/basic/BasicMapController';

/** Basic presentation binds to the common workspace; it never creates a map. */
export default function MapContainer({ active = true }) {
  const map = useSharedMap();
  return <>
    <SharedMapViewport active={active} className="basic-map-viewport" />
    {map.ready && map.basicPort ? <BasicMapController map={map.basicPort} active={active} /> : null}
  </>;
}
