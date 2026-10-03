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

sortsys_s3_image() {
  printf '%s\n' 'localhost/sortsys-s3:source'
}

# Rebuild on each invocation so changes to the pinned sources or base image take
# effect. Unchanged Dockerfile layers are cached. Custom images remain pullable.
sortsys_prepare_s3_image() {
  local runtime="$1"
  local image="$2"
  local go_image="$3"
  local script_dir="${BASH_SOURCE[0]%/*}"

  if [ "$image" != "$(sortsys_s3_image)" ]; then
    ensure_image "$image" 5
    return $?
  fi

  echo "Building cached MinIO and mc image from pinned official source releases"
  "$runtime" build \
    --build-arg "GO_IMAGE=$go_image" \
    --file "$script_dir/Dockerfile.s3" \
    --tag "$image" \
    "$script_dir"
}
