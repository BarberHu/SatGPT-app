import { useCallback, useState } from 'react';
import { downloadAgentRasterFile } from '../services/agentApi';
import { trackUxEvent } from '../utils/analytics';
import { downloadBlobFile } from '../utils/downloads';

const useAgentRasterDownload = ({ aoi, setWarning }) => {
  const [downloadState, setDownloadState] = useState({});

  const downloadRaster = useCallback(async ({ layerKey, title, requestParams = null }) => {
    if (!aoi) {
      setWarning?.('Please select an AOI before downloading raster data.');
      return;
    }

    setDownloadState((previous) => ({
      ...previous,
      [layerKey]: {
        status: 'preparing',
        message: 'Preparing AOI GeoTIFF...',
      },
    }));

    try {
      setWarning?.('');
      const response = await downloadAgentRasterFile({
        layer_key: layerKey,
        aoi,
        ...(requestParams || {}),
      });
      if (!response?.blob) {
        throw new Error('Raster file was not returned.');
      }

      downloadBlobFile(response.blob, response.filename);
      setDownloadState((previous) => ({
        ...previous,
        [layerKey]: {
          status: 'success',
          message: response.scale ? `Download started at ${response.scale}m resolution.` : 'Download started.',
        },
      }));
      trackUxEvent('download_agent_raster', {
        layerKey,
        title,
        scope: aoi?.label || null,
      });
    } catch (error) {
      const message = error?.message || 'Raster download failed.';
      setDownloadState((previous) => ({
        ...previous,
        [layerKey]: { status: 'error', message },
      }));
      setWarning?.(message);
    }
  }, [aoi, setWarning]);

  return { downloadState, downloadRaster };
};

export default useAgentRasterDownload;
