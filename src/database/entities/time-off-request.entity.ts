import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum TimeOffStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ name: 'employee_id', type: 'varchar', length: 255 })
  employeeId!: string;

  @Column({ name: 'location_id', type: 'varchar', length: 255 })
  locationId!: string;

  @Column({ name: 'days_requested', type: 'float' })
  daysRequested!: number;

  @Column({ name: 'start_date', type: 'varchar', length: 20 })
  startDate!: string;

  @Column({ name: 'end_date', type: 'varchar', length: 20 })
  endDate!: string;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason!: string;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: TimeOffStatus.PENDING,
  })
  status!: TimeOffStatus;

  @Column({ name: 'manager_id', type: 'varchar', length: 255, nullable: true })
  managerId!: string;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string;

  @Column({ name: 'hcm_synced', type: 'boolean', default: false })
  hcmSynced!: boolean;

  @Column({ name: 'hcm_response', type: 'text', nullable: true })
  hcmResponse!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}