import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsDateString,
  IsOptional,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTimeOffRequestDto {
  @ApiProperty({ description: 'Unique key to ensure exactly-once processing', example: 'emp-123-2024-01-15-req-1' })
  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @ApiProperty({ description: 'Employee ID', example: 'emp-123' })
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ description: 'Location ID for balance lookup', example: 'loc-us-hq' })
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @ApiProperty({ description: 'Number of days being requested', example: 2.5 })
  @IsNumber()
  @IsPositive()
  @Min(0.5)
  @Max(365)
  daysRequested: number;

  @ApiProperty({ description: 'Start date of time off (YYYY-MM-DD)', example: '2024-03-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ description: 'End date of time off (YYYY-MM-DD)', example: '2024-03-05' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional({ description: 'Reason for time off request', example: 'Family vacation' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({ description: 'Manager ID for approval routing', example: 'mgr-456' })
  @IsOptional()
  @IsString()
  managerId?: string;
}