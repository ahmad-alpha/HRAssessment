import { Injectable, Logger } from '@nestjs/common';

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  availableDays: number;
  totalDays: number;
  usedDays: number;
}

export interface HcmDeductResult {
  success: boolean;
  errorMessage?: string;
  remainingBalance?: number;
  details?: any;
}

@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);

  async getBalance(employeeId: string, locationId: string): Promise<HcmBalance> {
    this.logger.log(`Fetching balance from HCM for ${employeeId} @ ${locationId}`);
    return {
      employeeId,
      locationId,
      availableDays: 10,
      totalDays: 10,
      usedDays: 0,
    };
  }

  async getBatchBalances(): Promise<HcmBalance[]> {
    this.logger.log(`Fetching batch balances from HCM`);
    return [];
  }

  async deductBalance(payload: {
    requestId: string;
    employeeId: string;
    locationId: string;
    days: number;
    startDate: string;
    endDate: string;
  }): Promise<HcmDeductResult> {
    this.logger.log(`Submitting balance deduction to HCM for request ${payload.requestId}`);
    return { success: true, details: payload };
  }
}
