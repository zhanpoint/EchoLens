export type CommentAuthor = {
  id: string;
  name: string;
};

export type Comment = {
  author: CommentAuthor;
  id: string;
  likeCount: number;
  publishedAt: number;
  text: string;
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
