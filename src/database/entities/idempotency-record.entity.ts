import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum IdempotencyStatus {
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('idempotency_records')
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ name: 'request_hash', type: 'varchar', length: 255 })
  requestHash!: string;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: IdempotencyStatus.PROCESSING,
  })
  status!: IdempotencyStatus;

  @Column({ name: 'response_body', type: 'text', nullable: true })
  responseBody!: string;

  @Column({ name: 'response_status_code', type: 'integer', nullable: true })
  responseStatusCode!: number;

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}