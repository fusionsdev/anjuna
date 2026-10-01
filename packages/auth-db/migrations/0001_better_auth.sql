-- Migration 0001 — better-auth schema on D1 (`auth`) for the control panel (FA-3).
--
-- Generated from better-auth 1.7 core tables + the `admin` plugin (role, ban, impersonation)
-- with its SQLite dialect (`getMigrations(...).compileMigrations()`), then changed in one place:
--   "role" is NOT NULL, defaults to 'employee' and only accepts 'owner' | 'employee'.
-- The control panel must configure the admin plugin with `defaultRole: "employee"` and
-- `adminRoles: ["owner"]` (roles defined via createAccessControl); any other role value — including
-- better-auth's stock default "user" or a comma-separated multi-role — is rejected by the CHECK.
-- test/auth-db.test.ts asserts better-auth sees nothing left to migrate on this schema.
-- Identifiers are camelCase because that is better-auth's default field naming.

create table "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" integer not null,
  "image" text,
  "createdAt" date not null,
  "updatedAt" date not null,
  "role" text not null default 'employee' check ("role" in ('owner', 'employee')),
  "banned" integer,
  "banReason" text,
  "banExpires" date
);

create table "session" (
  "id" text not null primary key,
  "expiresAt" date not null,
  "token" text not null unique,
  "createdAt" date not null,
  "updatedAt" date not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade,
  "impersonatedBy" text
);

create table "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

create table "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" date not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");
