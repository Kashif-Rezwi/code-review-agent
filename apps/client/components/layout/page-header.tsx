import type { LucideIcon } from 'lucide-react'

interface PageHeaderProps {
    icon?: LucideIcon
    iconClassName?: string
    title: string
    description: string
}

export function PageHeader({ icon: Icon, iconClassName = 'text-blue-400', title, description }: PageHeaderProps) {
    return (
        <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                {Icon && <Icon className={`w-6 h-6 ${iconClassName}`} />}
                {title}
            </h1>
            <p className="text-gray-400 text-sm mt-1">{description}</p>
        </div>
    )
}
