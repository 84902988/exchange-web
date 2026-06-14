import { redirect } from 'next/navigation';

export default function IdentityRedirectPage() {
  redirect('/user/kyc');
}
