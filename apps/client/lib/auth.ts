import NextAuth, { NextAuthOptions } from 'next-auth'
import GitHubProvider from 'next-auth/providers/github'
import type { JWT } from 'next-auth/jwt'
import type { Session } from 'next-auth'

export const authOptions: NextAuthOptions = {
    providers: [
        GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID!,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!,
            authorization: {
                params: {
                    // read:user + user:email for auth; repo for private PR access
                    scope: 'read:user user:email repo',
                },
            },
        }),
    ],

    callbacks: {
        // Persist the GitHub OAuth access token into the JWT on first sign-in
        async jwt({ token, account }: { token: JWT; account: { access_token?: string } | null }) {
            if (account?.access_token) {
                token.githubToken = account.access_token
            }
            return token
        },

        // Expose the GitHub token on the client-side session (typed as string | undefined)
        async session({ session, token }: { session: Session; token: JWT }) {
            session.githubToken = token.githubToken
            return session
        },
    },

    pages: {
        signIn: '/login',
    },

    session: {
        strategy: 'jwt',
    },
}

export default NextAuth(authOptions)
