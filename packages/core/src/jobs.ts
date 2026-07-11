/** pg-boss queue names and payloads (web → worker contract, plan §3.6). */
export const JOB_QUEUES = {
  checkProduct: 'check_product',
  checkAll: 'check_all',
  testNotification: 'test_notification',
} as const;

export interface CheckProductJob {
  productId: string;
}
