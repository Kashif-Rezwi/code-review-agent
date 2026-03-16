import React from 'react'

// Each entry: [spaceIndent, [[color, widthPx]...]]
// widths = charCount × 7.8px (JetBrains Mono 13px char width), operators merged into adjacent bars
const SKELETON_LINES: [number, [string, number][]][] = [
    // async function getUser(id) {       — 0 indent
    // "async"=39 "function"=62 "getUser"=55 "(id) {"=47
    [0, [['#569cd6', 39], ['#569cd6', 62], ['#dcdcaa', 55], ['#d4d4d4', 47]]],
    // ··const user = await db.query("SELECT * FROM users WHERE id = " + id)
    // "const"=39 "user ="=47 "await"=39 "db.query("=70 str=210 "+ id)"=39
    [2, [['#569cd6', 39], ['#9cdcfe', 47], ['#569cd6', 39], ['#dcdcaa', 70], ['#ce9178', 210], ['#9cdcfe', 39]]],
    // ··return user                      — 2-space indent
    [2, [['#569cd6', 47], ['#9cdcfe', 31]]],
    // }
    [0, [['#d4d4d4', 8]]],
]

export function EditorSkeleton() {
    return (
        <div className="h-[300px] w-full bg-[#0f1521] overflow-hidden relative"
            style={{ fontFamily: '"JetBrains Mono","Fira Code",monospace', fontSize: 13, lineHeight: '19px' }}>

            {/* code rows — pt-3 matches Monaco's paddingTop:12 option */}
            <div className="flex flex-col pt-3">
                {SKELETON_LINES.map(([indent, bars], i) => (
                    <div key={i} className="flex items-center" style={{ height: 21 }}>
                        {/* gutter: 54px wide, right-aligned num, 12px right pad */}
                        <div className="shrink-0 select-none text-right pr-[12px]"
                            style={{ width: 54, fontSize: 14, color: '#858585' }}>
                            {i + 1}
                        </div>
                        {/* bars — gap-[8px] represents a space char (~7.8px), indent in 8px/space steps */}
                        <div className="flex items-center gap-[8px]" style={{ paddingLeft: 16 + indent * 8 }}>
                            {bars.map(([color, width], j) => (
                                <div key={j} className="rounded-[3px] shrink-0"
                                    style={{ backgroundColor: color, width, height: 12, opacity: 0.45 }} />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
