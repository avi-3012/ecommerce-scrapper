/** pg-boss queue names and payloads (web → worker contract, plan §3.6). */
export const JOB_QUEUES = {
  checkProduct: 'check_product',
  checkAll: 'check_all',
  testNotification: 'test_notification',
  /**
   * Registration preview. The API used to fetch the listing itself, which meant
   * two processes scraping the same marketplaces from one IP with two identity
   * pools and two views of the request budget — and, once the API moved to a
   * cloud host, from a datacenter address the marketplaces refuse outright.
   * Preview is now a job: the worker owns every outbound request, wherever the
   * API happens to run.
   */
  previewProduct: 'preview_product',
} as const;

export interface CheckProductJob {
  productId: string;
}

export interface PreviewProductJob {
  /** Raw user input — a listing URL or a share/short link. */
  url: string;
}
