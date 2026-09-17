'use client';

import { useEffect } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import styles from './download.module.css';

type DownloadConfiguration = {
  appName: string;
  androidUrl: string;
  version: string;
  sizeBytes: number;
  minimumAndroidVersion: string;
  qrCodeUrl: string;
  homePreviewUrl: string;
  chartPreviewUrl: string;
};

function Icon({ kind }: { kind: 'download' | 'chart' | 'market' | 'wallet' | 'arrow' }) {
  const paths = {
    download: 'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5',
    chart: 'M3 3v18h18M7 15l4-5 4 3 5-7',
    market: 'M5 4v16M3 9h4M10 2v20M8 6h4M15 5v15M13 14h4M20 3v18M18 8h4',
    wallet: 'M20 7V4H4a2 2 0 0 0 0 4h16v12H4a2 2 0 0 1-2-2V6m18 6h-5v4h5m-2-2h.01',
    arrow: 'M5 12h14m-5-5 5 5-5 5',
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

export default function DownloadPage({ configuration: config }: { configuration: DownloadConfiguration }) {
  const { t, locale } = useLocaleContext();
  const text = (key: string) => t(`downloadPage${key}`, 'common')
    .replaceAll('{appName}', config.appName)
    .replaceAll('{androidVersion}', config.minimumAndroidVersion);
  const title = text('Title');
  const size = config.sizeBytes > 0
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(config.sizeBytes / 1024 / 1024)
    : '';

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <main className={styles.page} lang={locale === 'zh' ? 'zh-CN' : locale}>
      <section className={styles.hero} aria-labelledby="download-heading">
        <div className={`${styles.wrap} ${styles.heroInner}`}>
          <div className={styles.copy}>
            <p className={styles.eyebrow}>{text('Eyebrow')}</p>
            <h1 id="download-heading">{text('Headline')}<span>{text('Highlight')}</span></h1>
            <p className={styles.intro}>{text('Intro')}</p>
            {config.androidUrl ? (
              <a href={config.androidUrl} className={styles.download} download>
                <Icon kind="download" />{text('Android')}
              </a>
            ) : <p role="status" className={styles.unavailable}>{text('Unavailable')}</p>}
            <div className={styles.version}>
              {config.version && <span>{text('Version')} {config.version}</span>}
              {size && <span>{size} MB</span>}
              {config.minimumAndroidVersion && <span>Android {config.minimumAndroidVersion}+</span>}
            </div>
            {config.qrCodeUrl && config.androidUrl && (
              <div className={styles.scan}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={config.qrCodeUrl} alt={text('QrAlt')} width={96} height={96} />
                <div><strong>{text('Scan')}</strong><p>{text('ScanHint')}</p>
                  <a href="#installation">{text('Guide')}<Icon kind="arrow" /></a>
                </div>
              </div>
            )}
          </div>
          {(config.homePreviewUrl || config.chartPreviewUrl) && (
            <div className={styles.showcase} role="group" aria-label={text('PreviewLabel')}>
              <div className={styles.halo} aria-hidden="true" />
              {config.chartPreviewUrl && <div className={`${styles.phone} ${styles.back}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={config.chartPreviewUrl} alt={text('ChartAlt')} width={1080} height={2400} />
              </div>}
              {config.homePreviewUrl && <div className={`${styles.phone} ${styles.front}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={config.homePreviewUrl} alt={text('HomeAlt')} width={1080} height={2400} />
              </div>}
              <div className={styles.previewLabel}><Icon kind="chart" /><span>{text('PreviewCaption')}<small>{text('PreviewSubcaption')}</small></span></div>
              <p className={styles.previewNote}>{text('PreviewNote')}</p>
            </div>
          )}
        </div>
      </section>
      <section className={`${styles.wrap} ${styles.features}`} aria-label={text('Features')}>
        {(['market', 'chart', 'wallet'] as const).map((kind, index) => (
          <article className={styles.feature} key={kind}>
            <Icon kind={kind} /><div><h2>{text(`Feature${index + 1}`)}</h2><p>{text(`Feature${index + 1}Body`)}</p></div>
          </article>
        ))}
      </section>
      <section className={styles.install} id="installation" aria-labelledby="installation-heading">
        <div className={styles.wrap}>
          <div className={styles.sectionHeading}>
            <h2 id="installation-heading">{text('InstallTitle')}</h2>
            {config.minimumAndroidVersion && <p>{text('InstallSubtitle')}</p>}
          </div>
          <ol className={styles.steps}>
            {[1, 2, 3].map((step) => <li className={styles.step} key={step}>
              <span className={styles.number} aria-hidden="true">0{step}</span>
              <h3>{text(`Step${step}`)}</h3><p>{text(`Step${step}Body`)}</p>
            </li>)}
          </ol>
          <div className={styles.faq}>
            {['Install', 'Update'].map((topic) => <details key={topic}>
              <summary>{text(`Faq${topic}`)}</summary><p>{text(`Faq${topic}Body`)}</p>
            </details>)}
          </div>
        </div>
      </section>
    </main>
  );
}
