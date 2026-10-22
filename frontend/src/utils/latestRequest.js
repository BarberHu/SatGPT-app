export const finalizeLatestRequest = ({
  requestKeyRef,
  requestKey,
  setLoading,
  releaseForRetry = false,
}) => {
  if (requestKeyRef.current !== requestKey) {
    return false;
  }

  setLoading(false);
  if (releaseForRetry) {
    requestKeyRef.current = null;
  }
  return true;
};
