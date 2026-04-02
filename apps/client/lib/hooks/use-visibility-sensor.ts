import { useState, useEffect, RefObject } from 'react'

export function useVisibilitySensor(ref: RefObject<HTMLElement | null>, defaultVisible = true) {
    const [isVisible, setIsVisible] = useState(defaultVisible)

    useEffect(() => {
        const el = ref.current
        if (!el) { setIsVisible(defaultVisible); return }
        
        const observer = new IntersectionObserver(
            ([entry]) => setIsVisible(entry.isIntersecting),
            { threshold: 0 },
        )
        observer.observe(el)
        
        return () => observer.disconnect()
    }, [ref, defaultVisible])

    return isVisible
}
