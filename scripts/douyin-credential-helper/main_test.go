package main

import "testing"

func TestFilterDouyinCookies(t *testing.T) {
	cookies := filterDouyinCookies([]browserCookie{
		{Domain: ".douyin.com", Name: "ttwid", Value: "token"},
		{Domain: "www.douyin.com", Name: "sessionid", Value: "session"},
		{Domain: "notdouyin.com", Name: "sessionid", Value: "wrong"},
		{Domain: "douyin.com", Name: "empty", Value: ""},
	})

	if len(cookies) != 2 {
		t.Fatalf("expected 2 valid Douyin cookies, got %d", len(cookies))
	}
	if cookies[0].Name != "sessionid" || cookies[1].Name != "ttwid" {
		t.Fatalf("cookies were not sorted by name: %#v", cookies)
	}
	if !hasLoginCookie(cookies) {
		t.Fatal("expected login cookie to be detected")
	}
}

func TestHasLoginCookieRejectsNonLoginCookies(t *testing.T) {
	if hasLoginCookie([]browserCookie{{Name: "ttwid", Value: "token"}}) {
		t.Fatal("non-login cookies must not be accepted")
	}
}
