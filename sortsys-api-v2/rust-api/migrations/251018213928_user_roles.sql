CREATE TABLE user_roles (name VARCHAR(63) NOT NULL PRIMARY KEY);

CREATE TABLE user_role_assignments (
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_name TEXT NOT NULL REFERENCES user_roles (name) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_name)
);

CREATE INDEX ON user_role_assignments (user_id);

CREATE INDEX ON user_role_assignments (role_name);

INSERT INTO
  user_roles (name)
VALUES
  (':admin'),
  -- users
  ('view:users'),
  ('manage:users'),
  ('delete:users'),
  -- projects
  ('view:projects'),
  ('manage:projects'),
  ('delete:projects'),
  ('view:projectDeployments'),
  ('manage:projectDeployments'),
  ('delete:projectDeployments'),
  -- tools
  ('view:tools'),
  ('manage:tools'),
  ('delete:tools'),
  ('view:toolTrackings'),
  ('manage:toolTrackings'),
  ('delete:toolTrackings'),
  ('view:toolInventories'),
  ('manage:toolInventories'),
  ('delete:toolInventories'),
  -- products
  ('view:products'),
  ('manage:products'),
  ('delete:products'),
  ('view:deliveryNotes'),
  ('manage:deliveryNotes'),
  ('delete:deliveryNotes'),
  ('view:productVendors'),
  ('manage:productVendors'),
  ('delete:productVendors'),
  ('view:productPriceRecords'),
  ('manage:productPriceRecords'),
  ('delete:productPriceRecords'),
  -- customers
  ('view:customers'),
  ('manage:customers'),
  ('delete:customers'),
  -- contacts
  ('view:contacts'),
  ('manage:contacts'),
  ('delete:contacts');
