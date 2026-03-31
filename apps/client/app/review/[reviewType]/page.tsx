import { ReviewPageClient } from '@/components/review/review-page-client'
import { notFound } from 'next/navigation'

export default async function ReviewTypePage({ params }: { params: Promise<{ reviewType: string }> }) {
    const { reviewType } = await params
    
    if (reviewType !== 'github_pr' && reviewType !== 'paste_code') {
        return notFound()
    }

    return <ReviewPageClient initialReviewType={reviewType} />
}
