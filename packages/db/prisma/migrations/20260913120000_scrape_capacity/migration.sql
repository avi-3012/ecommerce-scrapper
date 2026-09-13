-- How many products are actively scraped, settable without a redeploy.
--
-- NULL means "fall back to limits.capacity in the scraping config", so an
-- existing deployment keeps whatever it is running today until someone
-- deliberately changes it in Settings.
ALTER TABLE "settings" ADD COLUMN "scrape_capacity" INTEGER;

-- Priority now reads HIGHER-WINS: 2 outranks 1.
--
-- No data migration, deliberately. Every product sits at the default of 1, so
-- there is no existing ranking to invert — reversing the comparison changes
-- nothing about the current order, and the first number anyone types under the
-- new rule means what the UI says it means. Renumbering rows to preserve an
-- ordering that nobody has expressed would invent intent that is not there.
