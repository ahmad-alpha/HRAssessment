import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveTimeOffDto {
  @ApiProperty({ description: 'Manager ID approving the request', example: 'mgr-456' })
  @IsString()
  @IsNotEmpty()
  managerId: string;
}

export class RejectTimeOffDto {
  @ApiProperty({ description: 'Manager ID rejecting the request', example: 'mgr-456' })
  @IsString()
  @IsNotEmpty()
  managerId: string;

  @ApiPropertyOptional({ description: 'Reason for rejection', example: 'Insufficient coverage during that period' })
  @IsOptional()
  @IsString()
  rejectionReason?: string;
}

export class SyncBalanceDto {
  @ApiProperty({ description: 'Employee ID', example: 'emp-123' })
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ description: 'Location ID', example: 'loc-us-hq' })
  @IsString()
  @IsNotEmpty()
  locationId: string;
}