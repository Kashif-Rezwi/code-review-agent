import { ReviewPageClient } from '@/components/review/review-page-client'

export const metadata = {
    title: 'Review Your Code',
}

export default function ReviewPage() {
    return <ReviewPageClient initialReviewType="paste_code" />
}
