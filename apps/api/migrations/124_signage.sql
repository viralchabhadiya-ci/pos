-- TV signage: playlists of slides (pictures, price boards, offers, messages, videos) shown on
-- screens in the stores. A screen is a TV browser opening its own private link.

CREATE TABLE signage_media (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  bytes bytea NOT NULL,
  size int NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_media_tenant_idx ON signage_media (tenant_id, created_at DESC);

CREATE TABLE signage_playlists (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE signage_slides (
  id uuid PRIMARY KEY,
  playlist_id uuid NOT NULL REFERENCES signage_playlists(id) ON DELETE CASCADE,
  position int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'prices', 'promo', 'message', 'video')),
  -- Seconds on screen. A price board with more products than fit pages through them in this time.
  duration int NOT NULL DEFAULT 10 CHECK (duration BETWEEN 3 AND 300),
  media_id uuid REFERENCES signage_media(id),
  category_id uuid REFERENCES categories(id),
  promotion_id uuid REFERENCES promotions(id),
  title text,
  title_ar text,
  body text,
  body_ar text,
  video_url text CHECK (video_url ~ '^https://'),
  theme text NOT NULL DEFAULT 'brand' CHECK (theme IN ('brand', 'dark', 'light', 'offer')),
  -- When it shows, in the store's time: dates, days of the week (0 = Sunday) and hours.
  starts_on date,
  ends_on date,
  days int[],
  start_time text CHECK (start_time ~ '^\d{2}:\d{2}$'),
  end_time text CHECK (end_time ~ '^\d{2}:\d{2}$'),
  active boolean NOT NULL DEFAULT true,
  CHECK (kind <> 'image' OR media_id IS NOT NULL),
  CHECK (kind <> 'promo' OR promotion_id IS NOT NULL),
  CHECK (kind <> 'video' OR video_url IS NOT NULL)
);
CREATE INDEX signage_slides_playlist_idx ON signage_slides (playlist_id, position);

CREATE TABLE signage_screens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  name text NOT NULL,
  playlist_id uuid REFERENCES signage_playlists(id) ON DELETE SET NULL,
  orientation text NOT NULL DEFAULT 'landscape' CHECK (orientation IN ('landscape', 'portrait')),
  -- Language of price boards and offers.
  lang text NOT NULL DEFAULT 'both' CHECK (lang IN ('en', 'ar', 'both')),
  -- The screen's private link (/tv#<token>). Kept readable so the back office can show it
  -- again: it only opens this screen's slides, which customers see in the shop anyway.
  token text NOT NULL UNIQUE,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signage_screens_store_idx ON signage_screens (tenant_id, store_id);

-- Connecting a TV without typing a link: the TV shows a code, the back office enters it.
CREATE TABLE signage_pair_codes (
  code text PRIMARY KEY,
  -- The TV's secret for picking up its screen link once the code is entered.
  claim text NOT NULL UNIQUE,
  screen_id uuid REFERENCES signage_screens(id) ON DELETE CASCADE,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX signage_pair_codes_ip_idx ON signage_pair_codes (ip, created_at);
