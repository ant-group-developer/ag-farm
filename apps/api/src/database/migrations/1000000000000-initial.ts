import { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1000000000000 implements MigrationInterface {
  name = 'Initial1000000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE farm_owners (
        id text PRIMARY KEY,
        key_hash char(64) NOT NULL UNIQUE,
        sign_url text NOT NULL,
        allowed_types text[] NOT NULL DEFAULT '{}',
        default_lane text NOT NULL DEFAULT 'batch',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE farm_nodes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        machine text NOT NULL DEFAULT '',
        kinds text[] NOT NULL DEFAULT '{}',
        token_hash char(64) NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        os text,
        cpu_cores int,
        ram_mb int,
        gpus jsonb,
        engines jsonb,
        capabilities jsonb,
        free_slots jsonb,
        running_job_ids uuid[] NOT NULL DEFAULT '{}',
        limits jsonb,
        schedule jsonb,
        last_seen_at timestamptz,
        agent_version text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE farm_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner text NOT NULL REFERENCES farm_owners(id),
        type text NOT NULL,
        lane text NOT NULL,
        status text NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','leased','completed','failed','cancelled')),
        priority int NOT NULL DEFAULT 0,
        requirements jsonb NOT NULL DEFAULT '{}',
        affinity_key text,
        not_before timestamptz,
        payload jsonb NOT NULL,
        result jsonb,
        error jsonb,
        correlation_id text NOT NULL,
        UNIQUE (owner, correlation_id),
        node_id uuid REFERENCES farm_nodes(id) ON DELETE SET NULL,
        lease_token text,
        lease_expires_at timestamptz,
        attempt_count int NOT NULL DEFAULT 0,
        max_attempts int NOT NULL DEFAULT 3,
        progress_percent real,
        progress_stage text,
        started_at timestamptz,
        finished_at timestamptz,
        acked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    /* Index tìm job queued để claim */
    await queryRunner.query(`
      CREATE INDEX farm_jobs_claim_idx
        ON farm_jobs (lane, priority DESC, created_at ASC)
        WHERE status = 'queued'
    `);

    /* Index poll unacked (terminal, chưa ack) */
    await queryRunner.query(`
      CREATE INDEX farm_jobs_unacked_idx
        ON farm_jobs (owner, acked_at)
        WHERE status IN ('completed','failed','cancelled') AND acked_at IS NULL
    `);

    /* Index reaper: leased quá hạn */
    await queryRunner.query(`
      CREATE INDEX farm_jobs_lease_expires_idx
        ON farm_jobs (lease_expires_at)
        WHERE status = 'leased'
    `);

    /* Index owner + status để list */
    await queryRunner.query(`
      CREATE INDEX farm_jobs_owner_status_idx
        ON farm_jobs (owner, status, updated_at ASC, id ASC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS farm_jobs`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm_nodes`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm_owners`);
  }
}
