'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { AppHeader } from '@/components/layout/app-header'
import { PageHeader } from '@/components/layout/page-header'
import { useWallet } from '@/lib/use-wallet'
import { paymentsService } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CreditCard, RefreshCw, Zap, ShieldCheck, History, ArrowDownRight, ArrowUpRight, Gift, CheckCircle2 } from 'lucide-react'

declare global {
    interface Window {
        Razorpay: new (options: Record<string, unknown>) => { open: () => void }
    }
}

export default function AccountPage() {
    const { data: session } = useSession()
    const token = (session as unknown as { accessToken?: string })?.accessToken

    const { balance, ledger, packages, isLoading, isPolling, error: walletError, refresh, startPolling } = useWallet(token)
    const [buyingPackageId, setBuyingPackageId] = useState<string | null>(null)
    const [checkoutError, setCheckoutError] = useState<string | null>(null)
    const [scriptLoaded, setScriptLoaded] = useState<boolean>(() => typeof window !== 'undefined' && Boolean(window.Razorpay))

    // Load Razorpay Checkout.js script
    useEffect(() => {
        if (typeof window === 'undefined' || window.Razorpay) return
        const script = document.createElement('script')
        script.src = 'https://checkout.razorpay.com/v1/checkout.js'
        script.async = true
        script.onload = () => setScriptLoaded(true)
        script.onerror = () => setCheckoutError('Failed to load Razorpay Checkout SDK.')
        document.body.appendChild(script)
    }, [])

    const handleBuy = async (packageId: string) => {
        if (!token) {
            setCheckoutError('Please log in to purchase credits.')
            return
        }
        if (!scriptLoaded || !window.Razorpay) {
            setCheckoutError('Razorpay payment gateway is initializing. Please try again in a moment.')
            return
        }

        setBuyingPackageId(packageId)
        setCheckoutError(null)

        try {
            const orderData = await paymentsService.createOrder({ packageId }, token)

            const options = {
                key: orderData.keyId,
                amount: orderData.amount,
                currency: orderData.currency,
                name: 'Code Review Agent',
                description: `Credit Top-Up (${orderData.amount / 100} INR)`,
                order_id: orderData.razorpayOrderId,
                handler: () => {
                    setBuyingPackageId(null)
                    startPolling()
                },
                modal: {
                    ondismiss: () => {
                        setBuyingPackageId(null)
                    },
                },
                theme: {
                    color: '#3B82F6',
                },
            }

            const razorpayInstance = new window.Razorpay(options)
            razorpayInstance.open()
        } catch (err) {
            setCheckoutError(err instanceof Error ? err.message : 'Failed to initiate checkout.')
            setBuyingPackageId(null)
        }
    }

    return (
        <div className="min-h-screen bg-app-bg text-gray-100 flex flex-col font-sans">
            <AppHeader />
            <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-8 space-y-8">
                <PageHeader
                    title="Account & Credits"
                    description="Manage your prepaid AI review credits, recharge your wallet, and view transaction history."
                />

                {/* Status Banners */}
                {walletError && (
                    <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
                        <span>{walletError}</span>
                    </div>
                )}

                {isPolling && (
                    <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/30 text-blue-300 flex items-center justify-between animate-pulse">
                        <div className="flex items-center gap-3">
                            <RefreshCw className="w-5 h-5 animate-spin text-blue-400" />
                            <div>
                                <p className="text-sm font-semibold">Payment Received! Syncing Wallet...</p>
                                <p className="text-xs text-blue-400/80">Your balance will update automatically once the webhook settles.</p>
                            </div>
                        </div>
                    </div>
                )}

                {checkoutError && (
                    <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm flex items-center justify-between">
                        <span>{checkoutError}</span>
                        <button onClick={() => setCheckoutError(null)} className="text-xs underline text-red-400">Dismiss</button>
                    </div>
                )}

                {/* Credit Balance Card */}
                <div className="p-6 rounded-2xl bg-[#0f1117] border border-white/10 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-6 relative overflow-hidden">
                    <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
                    
                    <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                            <Zap className="w-4 h-4 text-blue-400" />
                            <span>Available Balance</span>
                        </div>
                        <div className="flex items-baseline gap-3">
                            <span className="text-4xl font-extrabold text-white tracking-tight">{isLoading ? '...' : balance}</span>
                            <span className="text-lg font-medium text-slate-400">credits</span>
                        </div>
                        <p className="text-xs text-slate-400">
                            Costs: Code Review = 5 credits • PR Review = 10 credits • Chat = 1 credit
                        </p>
                    </div>

                    <div className="flex items-center gap-3">
                        <Button
                            variant="secondary"
                            onClick={() => void refresh()}
                            disabled={isLoading}
                            className="flex items-center gap-2"
                        >
                            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                            <span>Refresh</span>
                        </Button>
                    </div>
                </div>

                {/* Recharge Credit Packages */}
                <section className="space-y-4">
                    <div>
                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                            <CreditCard className="w-5 h-5 text-blue-400" />
                            <span>Recharge Credits</span>
                        </h2>
                        <p className="text-xs text-slate-400 mt-1">Select a credit pack to top up your balance using Razorpay (UPI, Cards, NetBanking).</p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {packages.map((pkg) => (
                            <div
                                key={pkg.id}
                                className="p-5 rounded-2xl bg-[#0f1117] border border-white/10 hover:border-blue-500/40 transition-all duration-200 flex flex-col justify-between space-y-4 shadow-lg group relative"
                            >
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-semibold text-blue-400 bg-blue-500/10 px-2.5 py-0.5 rounded-full border border-blue-500/20">
                                            {pkg.credits} Credits
                                        </span>
                                        <ShieldCheck className="w-4 h-4 text-slate-500 group-hover:text-blue-400 transition-colors" />
                                    </div>
                                    <div className="text-2xl font-bold text-white">
                                        ₹{pkg.amountPaise / 100}
                                    </div>
                                    <p className="text-xs text-slate-400">
                                        approx. {Math.floor(pkg.credits / 5)} code reviews or {Math.floor(pkg.credits / 10)} PR reviews
                                    </p>
                                </div>

                                <Button
                                    onClick={() => void handleBuy(pkg.id)}
                                    disabled={buyingPackageId === pkg.id}
                                    className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2 rounded-xl transition-all shadow-md shadow-blue-600/20"
                                >
                                    {buyingPackageId === pkg.id ? 'Opening Gateway...' : `Buy Pack (₹${pkg.amountPaise / 100})`}
                                </Button>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Ledger / Transaction History */}
                <section className="space-y-4">
                    <div>
                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                            <History className="w-5 h-5 text-blue-400" />
                            <span>Transaction History</span>
                        </h2>
                        <p className="text-xs text-slate-400 mt-1">Audit log of your credit grants, purchases, and review consumption.</p>
                    </div>

                    <div className="rounded-2xl bg-[#0f1117] border border-white/10 overflow-hidden shadow-xl">
                        {ledger.length === 0 ? (
                            <div className="p-8 text-center text-slate-400 text-sm">
                                {isLoading ? 'Loading transaction history...' : 'No transactions recorded yet.'}
                            </div>
                        ) : (
                            <div className="divide-y divide-white/5 max-h-96 overflow-y-auto">
                                {ledger.map((entry) => {
                                    const isPositive = entry.amount > 0
                                    return (
                                        <div key={entry.id} className="p-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                                                    entry.type === 'FREE_GRANT' ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20' :
                                                    entry.type === 'PURCHASE' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                                                    entry.type === 'CONSUMPTION_REFUND' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                                                    'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                                }`}>
                                                    {entry.type === 'FREE_GRANT' ? <Gift className="w-4 h-4" /> :
                                                     entry.type === 'PURCHASE' ? <ArrowDownRight className="w-4 h-4" /> :
                                                     entry.type === 'CONSUMPTION_REFUND' ? <CheckCircle2 className="w-4 h-4" /> :
                                                     <ArrowUpRight className="w-4 h-4" />}
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-white">{entry.description || entry.type}</p>
                                                    <p className="text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</p>
                                                </div>
                                            </div>

                                            <div className="text-right">
                                                <p className={`text-sm font-bold ${isPositive ? 'text-emerald-400' : 'text-slate-300'}`}>
                                                    {isPositive ? `+${entry.amount}` : entry.amount} credits
                                                </p>
                                                <p className="text-xs text-slate-500">Balance: {entry.balanceAfter}</p>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </section>
            </main>
        </div>
    )
}
