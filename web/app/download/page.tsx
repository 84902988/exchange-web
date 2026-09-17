import type { Metadata } from 'next';
import configuration from '@/config/appDownload.json';
import { applicationName } from '@/lib/branding';
import DownloadPage from './DownloadPage';

const appName = configuration.appName.trim() || applicationName;

export const metadata: Metadata = {
  title: `Download ${appName} App`,
};

export default function Page() {
  return <DownloadPage configuration={{ ...configuration, appName }} />;
}
