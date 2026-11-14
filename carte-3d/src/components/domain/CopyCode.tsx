'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Bloc de code avec bouton « Copier ». */
export default function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers refusé : le code reste sélectionnable à la main.
    }
  };
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-2xl bg-winter-900 p-4 pr-24 text-xs leading-relaxed text-white/90">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copié' : 'Copier'}
      </button>
    </div>
  );
}
