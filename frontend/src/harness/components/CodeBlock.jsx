import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/button';

export default function CodeBlock({ code, language = 'text', label }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setError(''); }
    catch { setError('Unable to copy. Select the code and copy it manually.'); }
  };
  return <div className="agent-code">
    <div className="agent-code-header"><span>{label || language}</span>
      <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label="Copy code">
        {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
    <pre tabIndex={0}><code className={`language-${language}`}>{code}</code></pre>
    {error ? <p role="status">{error}</p> : null}
  </div>;
}
