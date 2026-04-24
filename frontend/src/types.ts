export interface TimeOffRequest {
  id: string
  idempotencyKey: string
  employeeId: string
  locationId: string
  daysRequested: number
  startDate: string
  endDate: string
  reason?: string
  managerId?: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  rejectionReason?: string
  hcmSynced: boolean
  hcmResponse?: string
  createdAt: string
  updatedAt: string
}

export interface Balance {
  id: string
  employeeId: string
  locationId: string
  availableDays: number
  usedDays: number
  pendingDays: number
  totalDays: number
  lastHcmSync: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface CreateTimeOffRequestDto {
  idempotencyKey: string
  employeeId: string
  locationId: string
  daysRequested: number
  startDate: string
  endDate: string
  reason?: string
  managerId?: string
}
