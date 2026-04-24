import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('balances')
@Index(['employeeId', 'locationId'], { unique: true })
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'employee_id', type: 'varchar', length: 255 })
  employeeId!: string;

  @Column({ name: 'location_id', type: 'varchar', length: 255 })
  locationId!: string;

  @Column({ name: 'available_days', type: 'float', default: 0 })
  availableDays!: number;

  @Column({ name: 'used_days', type: 'float', default: 0 })
  usedDays!: number;

  @Column({ name: 'pending_days', type: 'float', default: 0 })
  pendingDays!: number;

  @Column({ name: 'total_days', type: 'float', default: 0 })
  totalDays!: number;

  @Column({ name: 'last_hcm_sync', type: 'datetime', nullable: true })
  lastHcmSync!: Date;

  @Column({ name: 'version', type: 'integer', default: 0 })
  version!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}