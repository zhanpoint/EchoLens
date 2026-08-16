export type CommentAuthor = {
  id: string;
  name: string;
};

export type CommentReply = {
  author: CommentAuthor;
  id: string;
  likeCount: number;
  publishedAt: number;
  text: string;
};

export type Comment = CommentReply & {
  replies: CommentReply[];
  replyCount: number;
  replyPageHasMore: boolean;
};

export type CommentsPayload = {
  collectedAt: number;
  commentCount: number;
  comments: Comment[];
};

export type CommentCollectionProgress = {
  commentCount: number;
  page: number;
};