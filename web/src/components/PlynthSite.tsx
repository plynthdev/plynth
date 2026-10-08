import { useEffect, useRef } from 'react';
import { mountSite } from '../site/runtime.js';
import '../site/fonts.css';
import '../site/style.css';
import '../site/updates.css';
import '../site/motion.css';
import '../fork/fork.css';
import { forkConfig } from '../fork/config';
import { liveDashboard } from '../fork/dashboard';

type SiteRuntime = ReturnType<typeof mountSite>;

export default function PlynthSite({ pathname }: { pathname?: string }) {
  const runtime = useRef<SiteRuntime | null>(null);
  const previousPath = useRef(pathname);
  useEffect(() => {
    // Live dashboard: reads the configured stack's API and signs with a real wallet (VITE_FORK=0: preview).
    runtime.current = mountSite(forkConfig().enabled ? { dashboard: liveDashboard } : {});
    return () => {
      runtime.current?.dispose();
      runtime.current = null;
    };
  }, []);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      runtime.current?.refresh();
    }
  }, [pathname]);
  return <>
    <a href="#main" className="skip-link">Skip to content</a>
    <header id="header" />
    <main id="main" tabIndex={-1} />
    <noscript><p>plynth — private round-ups and tokenized-stock investing. Enable JavaScript to explore the site and dashboard preview.</p></noscript>
    <div className="mouse-label" aria-hidden="true"><span /><b>YOU</b></div>
    <div className="hero-cursor" aria-hidden="true" data-shape="dot">
      <span className="hero-cursor-shape"><i className="tl" /><i className="tr" /><i className="bl" /><i className="br" /></span>
      <span className="hero-cursor-spark" />
    </div>
    <dialog id="soon-dialog" aria-labelledby="soon-title">
      <button className="dialog-close" aria-label="Close popup">×</button>
      <div className="dialog-symbol" aria-hidden="true">✣</div>
      <p className="mono" id="soon-channel" />
      <h2 id="soon-title" className="pixel">COMING SOON</h2>
    </dialog>
  </>;
}
