import { redirect } from 'next/navigation'

// Root redirect — middleware handles auth, this just avoids a blank page
export default function RootPage() {
  redirect('/dashboard')
}
