#!/usr/bin/env bash

# Source this file to resolve a script's default image from the Docker catalog.
sortsys_container_image() {
  local catalog="${BASH_SOURCE[0]%/*}/Dockerfile.images"
  awk -v name="$1" '
    $1 == "FROM" && $3 == "AS" && $4 == name {
      print $2
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$catalog"
}
