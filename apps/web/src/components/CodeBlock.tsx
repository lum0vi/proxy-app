import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePreferences } from '../lib/preferences';

export function CopyButton({ value }: { value: string }) {
  const { t, locale } = usePreferences();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    timer.current = window.setTimeout(() => setState('idle'), 2200);
  }

  return <button className="button small ghost" type="button" onClick={() => void copy()}>
    {state === 'copied' ? <Check size={15}/> : <Copy size={15}/>}
    <span aria-live="polite">{state === 'copied' ? t('copied') : state === 'failed'
      ? (locale === 'ru' ? 'Не удалось скопировать' : 'Copy failed') : (locale === 'ru' ? 'Копировать' : 'Copy')}</span>
  </button>;
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  return <div className="code-block">
    <div className="code-block-head"><span>{label}</span><CopyButton value={code}/></div>
    <pre tabIndex={0}><code>{code}</code></pre>
  </div>;
}
