import { ReviewPageClient } from '@/components/review/review-page-client'
import { notFound } from 'next/navigation'

export default async function ReviewSessionPage({ params }: { params: Promise<{ reviewType: string, reviewId: string }> }) {
    const { reviewType, reviewId } = await params
    
    if (reviewType !== 'github_pr' && reviewType !== 'paste_code') {
        return notFound()
    }

    return <ReviewPageClient initialReviewType={reviewType} initialReviewId={reviewId} />
}
