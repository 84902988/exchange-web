import { redirect } from 'next/navigation';

export default function AccessLogsLegacyPage() {
  redirect('/user/security/login-logs');
}
