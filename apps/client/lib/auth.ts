import NextAuth, { NextAuthOptions } from 'next-auth'
import GitHubProvider from 'next-auth/providers/github'

export const authOptions: NextAuthOptions = {
    providers: [
        GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID!,
            clientSecret: process.env.GITHUB_CLIENT_SECRET!,
            authorization: {
                params: {
                    scope: 'read:user user:email',
                },
            },
        }),
    ],

    callbacks: {
        async jwt({ token, account }) {
            // On first sign-in, persist the GitHub OAuth access token
            if (account?.access_token) {
                token.githubToken = account.access_token
            }
            return token
        },

        async session({ session, token }) {
            // Expose the GitHub token on the session so the client can send it to the backend
            session.githubToken = token.githubToken as string
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
