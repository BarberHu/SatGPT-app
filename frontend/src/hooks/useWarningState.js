import { useCallback, useRef, useState } from 'react';

export default function useWarningState() {
  const [warning, setWarningState] = useState('');
  const ownerRef = useRef(null);
  const setWarning = useCallback((value) => {
    ownerRef.current = null;
    setWarningState(value);
  }, []);
  const setOwnedWarning = useCallback((owner, message) => {
    ownerRef.current = owner;
    setWarningState(message);
  }, []);
  const clearOwnedWarning = useCallback((owner) => {
    if (ownerRef.current === owner) {
      ownerRef.current = null;
      setWarningState('');
    }
  }, []);
  return { warning, setWarning, setOwnedWarning, clearOwnedWarning };
}
