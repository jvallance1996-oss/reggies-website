#!/usr/bin/env python3
"""Refresh the public review cache from Google Places API (New)."""

import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "google-reviews.json"
API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "").strip()


def google_request(url, field_mask, payload=None):
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": field_mask,
    }
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=body, headers=headers, method="POST" if body else "GET")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main():
    if not API_KEY:
        print("GOOGLE_PLACES_API_KEY is not configured; keeping the existing review cache.")
        return 0

    search = google_request(
        "https://places.googleapis.com/v1/places:searchText",
        "places.id,places.displayName,places.formattedAddress",
        {
            "textQuery": "Reggie's Lawn and Outdoor Solutions Eynesbury Victoria",
            "languageCode": "en-AU",
            "regionCode": "AU",
        },
    )
    places = search.get("places", [])
    if not places:
        raise RuntimeError("Google Places did not return Reggie's business listing")

    place_id = places[0]["id"]
    details = google_request(
        f"https://places.googleapis.com/v1/places/{place_id}?languageCode=en-AU",
        "id,displayName,rating,userRatingCount,reviews,googleMapsUri",
    )

    reviews = []
    for review in details.get("reviews", [])[:5]:
        author = review.get("authorAttribution", {})
        text = review.get("text", {}).get("text", "").strip()
        if not text:
            continue
        reviews.append({
            "author": author.get("displayName", "Google reviewer"),
            "authorUri": author.get("uri", ""),
            "rating": review.get("rating", 5),
            "relativeTime": review.get("relativePublishTimeDescription", ""),
            "text": text,
        })

    if not reviews:
        raise RuntimeError("Google Places returned no written reviews; keeping the existing cache")

    output = {
        "placeName": details.get("displayName", {}).get("text", "Reggie's Lawn and Outdoor Solutions"),
        "placeId": place_id,
        "rating": details.get("rating", 0),
        "reviewCount": details.get("userRatingCount", 0),
        "googleMapsUri": details.get("googleMapsUri", ""),
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "reviews": reviews,
    }
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated {OUTPUT.name}: {output['rating']} from {output['reviewCount']} reviews")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (urllib.error.URLError, RuntimeError, KeyError) as error:
        print(f"Review refresh failed: {error}", file=sys.stderr)
        raise SystemExit(1)
