import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

const LONG_WAIT_MS = 30_000;
const toolLabels = {
  skill: 'Loading analysis instructions',
  geo_data_search: 'Finding saved data',
  geo_data_info: 'Checking saved data',
  geocode_place: 'Looking up a place',
  gee_status: 'Checking Earth Engine connection',
  gee_catalog: 'Looking up Earth Engine datasets',
  gee_eval: 'Running an Earth Engine query',
  gee_preview: 'Generating a map preview',
  gee_layer: 'Preparing a map layer',
  gee_publish_flood: 'Preparing flood results',
  gee_osm_analyze: 'Computing an overlay in Earth Engine',
  road_flood_exposure: 'Checking roads for flood exposure',
  osm_roads: 'Looking up OpenStreetMap roads',
  osm_buildings: 'Looking up OpenStreetMap buildings',
  osm_pois: 'Looking up OpenStreetMap places',
};

function statusLabel({ status, tool }, reconnecting, stopping, longWait) {
  if (status === 'cleaning') return 'Finishing…';
  if (status === 'cancelling' || stopping) return 'Stopping…';
  if (reconnecting) return 'Reconnecting…';
  if (status === 'queued') return longWait ? 'Still waiting in the queue' : 'Waiting in the queue';
  if (status === 'starting') return longWait ? 'Still starting…' : 'Starting…';
  const label = Object.hasOwn(toolLabels, tool) ? toolLabels[tool] : 'Analyzing';
  return longWait ? `Still working · ${label}` : label;
}

function ActivityStatus({ activity, reconnecting, stopping, startedAt }) {
  const [waitStartedAt] = useState(() => activity.noticeId ? Date.now() : startedAt);
  const [now, setNow] = useState(Date.now);
  const longWait = now - waitStartedAt >= LONG_WAIT_MS;
  useEffect(() => {
    const update = () => setNow(Date.now());
    if (longWait) {
      const timer = setInterval(update, 1000);
      return () => clearInterval(timer);
    }
    const timer = setTimeout(update, Math.max(0, waitStartedAt + LONG_WAIT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [longWait, waitStartedAt]);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const duration = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const label = statusLabel(activity, reconnecting, stopping, longWait);
  return <>
    <span className="agent-task-progress-label" role="status" title={label}>{label}</span>
    {longWait ? <span className="agent-task-progress-time" aria-hidden="true">· {duration} elapsed</span> : null}
  </>;
}

export default function TaskProgress({ activity, reconnecting, stopping }) {
  const [observedAt] = useState(Date.now);
  const createdAt = Date.parse(activity.createdAt);
  const startedAt = Number.isFinite(createdAt) ? Math.min(createdAt, observedAt) : observedAt;
  return <div className="agent-task-progress">
    <Loader2 className="agent-spin" size={14} aria-hidden="true" />
    <ActivityStatus key={activity.noticeId ?? 'initial'} activity={activity} reconnecting={reconnecting}
      stopping={stopping} startedAt={startedAt} />
  </div>;
}
