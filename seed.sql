-- ============================================================
-- Sample data for Your Day Diary
-- Run AFTER schema.sql (needs the tables to already exist).
-- In Workbench: File -> Open SQL Script -> seed.sql -> Execute (⚡)
--
-- All 3 sample accounts use the password:  password123
-- ============================================================

USE day_diary;

INSERT INTO users (username, email, password_hash, name, bio, settings) VALUES
('asha_k',   'asha@example.com',   '$2a$10$6tjT1vN8JQ1R7nqTSvRT5e6bSfyMv1I5VhY92YYCEWoIscdUJDm8K', 'Asha Kumar',   'Coffee, code, and cats.', JSON_OBJECT('privateAccount', false, 'showOnlineStatus', true, 'readReceipts', true, 'allowMessagesFrom', 'everyone', 'darkMode', false, 'emailNotifications', true, 'pushNotifications', true, 'twoFactorAuth', false, 'language', 'en', 'autoplayVideos', true)),
('ravi_dev',  'ravi@example.com',  '$2a$10$6tjT1vN8JQ1R7nqTSvRT5e6bSfyMv1I5VhY92YYCEWoIscdUJDm8K', 'Ravi Sharma',  'Building things, one bug at a time.', JSON_OBJECT('privateAccount', false, 'showOnlineStatus', true, 'readReceipts', true, 'allowMessagesFrom', 'everyone', 'darkMode', true, 'emailNotifications', true, 'pushNotifications', true, 'twoFactorAuth', false, 'language', 'en', 'autoplayVideos', true)),
('mira_p',    'mira@example.com',  '$2a$10$6tjT1vN8JQ1R7nqTSvRT5e6bSfyMv1I5VhY92YYCEWoIscdUJDm8K', 'Mira Patel',   'Traveling & journaling my day.', JSON_OBJECT('privateAccount', false, 'showOnlineStatus', true, 'readReceipts', true, 'allowMessagesFrom', 'followers', 'darkMode', false, 'emailNotifications', false, 'pushNotifications', true, 'twoFactorAuth', false, 'language', 'en', 'autoplayVideos', false));

INSERT INTO follows (follower_id, following_id)
SELECT u1.id, u2.id FROM users u1, users u2
WHERE (u1.username, u2.username) IN
  (('asha_k','ravi_dev'), ('asha_k','mira_p'), ('ravi_dev','asha_k'), ('mira_p','asha_k'));

INSERT INTO posts (user_id, content)
SELECT id, 'Just shipped a new feature today. Feels good!' FROM users WHERE username = 'ravi_dev';
INSERT INTO posts (user_id, content)
SELECT id, 'Morning walk + chai. Perfect start to the day.' FROM users WHERE username = 'asha_k';
INSERT INTO posts (user_id, content)
SELECT id, 'New city, new diary entries. Excited to explore!' FROM users WHERE username = 'mira_p';

INSERT INTO likes (post_id, user_id)
SELECT p.id, u.id FROM posts p, users u
WHERE p.content LIKE 'Just shipped%' AND u.username = 'asha_k';

INSERT INTO comments (post_id, user_id, text)
SELECT p.id, u.id, 'Congrats! Well deserved.' FROM posts p, users u
WHERE p.content LIKE 'Just shipped%' AND u.username = 'mira_p';

INSERT INTO shares (post_id, user_id)
SELECT p.id, u.id FROM posts p, users u
WHERE p.content LIKE 'Morning walk%' AND u.username = 'ravi_dev';