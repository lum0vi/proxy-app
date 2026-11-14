import type { FastifyRequest } from 'fastify';

export type Role = 'ADMIN' | 'USER';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
}

export type AuthenticatedRequest = FastifyRequest & { authUser: AuthUser };

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    rawBody?: string | Buffer;
    metricsStartedAt?: bigint;
  }
}
