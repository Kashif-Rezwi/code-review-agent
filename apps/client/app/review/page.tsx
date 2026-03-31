import { redirect } from 'next/navigation'

export const metadata = {
    title: 'Review Your Code',
}

export default function ReviewPage() {
    redirect('/review/paste_code')
}
