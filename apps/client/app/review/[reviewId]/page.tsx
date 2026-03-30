import { use } from 'react'
import { ReviewContainer } from '@/components/review/review-container'

export default function ReviewSessionPage(props: { params: Promise<{ reviewId: string }> }) {
    const params = use(props.params)
    return <ReviewContainer initialReviewId={params.reviewId} />
}
