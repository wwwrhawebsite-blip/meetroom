-- ============================================================
-- Your Day Diary - phpMyAdmin Compatible SQL Schema
-- Compatible with older MySQL/MariaDB free hosting
-- ============================================================

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";

DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS `groups`;
DROP TABLE IF EXISTS shares;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS likes;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS follows;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
id INT AUTO_INCREMENT PRIMARY KEY,
username VARCHAR(50) NOT NULL UNIQUE,
email VARCHAR(190) NOT NULL UNIQUE,
password_hash VARCHAR(255) NOT NULL,
name VARCHAR(100) NOT NULL,
bio TEXT,
avatar LONGTEXT,
is_online TINYINT(1) NOT NULL DEFAULT 0,
last_seen DATETIME NULL,
settings LONGTEXT,
created_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE follows (
follower_id INT NOT NULL,
following_id INT NOT NULL,
created_at DATETIME NULL,
PRIMARY KEY (follower_id, following_id),
FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE posts (
id INT AUTO_INCREMENT PRIMARY KEY,
user_id INT NOT NULL,
content TEXT,
image LONGTEXT,
created_at DATETIME NULL,
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE likes (
post_id INT NOT NULL,
user_id INT NOT NULL,
created_at DATETIME NULL,
PRIMARY KEY (post_id, user_id),
FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE comments (
id INT AUTO_INCREMENT PRIMARY KEY,
post_id INT NOT NULL,
user_id INT NOT NULL,
text TEXT NOT NULL,
created_at DATETIME NULL,
FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shares (
id INT AUTO_INCREMENT PRIMARY KEY,
post_id INT NOT NULL,
user_id INT NOT NULL,
created_at DATETIME NULL,
FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `groups` (
id INT AUTO_INCREMENT PRIMARY KEY,
name VARCHAR(100) NOT NULL,
avatar LONGTEXT,
creator_id INT NOT NULL,
created_at DATETIME NULL,
FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE group_members (
group_id INT NOT NULL,
user_id INT NOT NULL,
joined_at DATETIME NULL,
PRIMARY KEY (group_id, user_id),
FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE messages (
id INT AUTO_INCREMENT PRIMARY KEY,
sender_id INT NOT NULL,
receiver_id INT DEFAULT NULL,
group_id INT DEFAULT NULL,
text TEXT NOT NULL,
is_read TINYINT(1) NOT NULL DEFAULT 0,
created_at DATETIME NULL,
FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE blocks (
blocker_id INT NOT NULL,
blocked_id INT NOT NULL,
created_at DATETIME NULL,
PRIMARY KEY (blocker_id, blocked_id),
FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_posts_user ON posts(user_id);
CREATE INDEX idx_messages_pair ON messages(sender_id, receiver_id);
CREATE INDEX idx_messages_group ON messages(group_id);
CREATE INDEX idx_comments_post ON comments(post_id);

COMMIT;
